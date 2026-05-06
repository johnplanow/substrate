---
external_state_dependencies:
  - subprocess
  - filesystem
  - database
---

# Story 72-2: --non-interactive + Machine-Readable Exit Codes

## Story

As a CI/CD pipeline operator,
I want a `--non-interactive` flag on `substrate run` paired with machine-readable exit codes,
so that automated pipelines can invoke substrate without blocking on operator prompts and can programmatically determine run outcomes via exit codes 0/1/2.

## Acceptance Criteria

<!-- source-ac-hash: 01e8cece56608e2eef609cff443e93009e6b35d885f6729a2d187bfbb3fbdf9f -->

1. New CLI flag `--non-interactive` registered on `substrate run` at
   `src/cli/commands/run.ts`. Default value: `false`.

2. **Stdin prompt suppression**: when `--non-interactive` is true,
   any operator prompt path (existing `readline`/`process.stdin`
   reads in the orchestrator) is replaced with the configured
   `defaultAction` from `routeDecision` (Story 72-1). No stdin
   reads occur during a non-interactive run.

3. **Exit code derivation** at run completion in
   `src/modules/implementation-orchestrator/orchestrator-impl.ts`
   (or wherever pipeline completion is handled):
   - Exit `0` when `succeeded.length === total` AND `failed.length
     === 0` AND `escalated.length === 0`
   - Exit `0` when `succeeded.length + recovered.length === total`
     AND `failed.length === 0` AND `escalated.length === 0`
     (recovery counts as success)
   - Exit `1` when `escalated.length > 0` AND `failed.length === 0`
     (some stories escalated but run completed)
   - Exit `2` when `failed.length > 0` OR cost-ceiling-exhausted OR
     fatal halt reached OR orchestrator died (run-level failure)

4. **Combined flag behavior**: `--non-interactive --halt-on none
   --events --output-format json` is the canonical CI/CD invocation.
   This combination MUST:
   - Produce zero stdin reads
   - Emit NDJSON event stream to stdout (via `--events`)
   - Exit with codes 0/1/2 per AC3
   - Never block

5. **`--non-interactive` without `--halt-on`**: defaults to
   `--halt-on critical`. If a critical halt is reached, log a
   structured `decision:halt-skipped-non-interactive` event AND
   apply the default action AND mark the decision in the run
   manifest as `halt-skipped`. This is so operators reviewing the
   run via Epic 71's `substrate report` see what halts were skipped.

6. **Use canonical helpers** (per Story 69-2 / 71-2 lesson):
   - Use existing `RunManifest` for state writes (no new format)
   - Use `DoltClient` for persistence
   - Run-id resolution via `manifest-read.ts` helpers

7. New event type declared + mirrored:
   - `decision:halt-skipped-non-interactive` — `{ runId,
     decisionType, severity, defaultAction, reason }`

8. Tests at
   `src/modules/decision-router/__tests__/non-interactive.test.ts`
   (≥4 cases): (a) `--non-interactive` suppresses stdin reads;
   (b) exit code 0 when all stories succeed; (c) exit code 1 when
   any story escalates; (d) exit code 2 when run-level failure.

9. Integration test at
   `__tests__/integration/non-interactive-run.test.ts` (≥1 case):
   spawn `substrate run --non-interactive --halt-on none --events
   --stories <test-fixture>` as child process; assert no stdin
   reads occur (use a closed stdin pipe); assert exit code matches
   AC3 semantics.

10. **Header comment** in implementation file cites Phase D Story
    54-6 (original 2026-04-05 spec) + Story 72-1 (Decision Router
    that 72-2 consumes) + that this enables strata + agent-mesh
    cross-project CI/CD invocation.

11. **Help text update** on `substrate run --help`: document
    `--non-interactive` semantics + canonical CI/CD invocation
    combo + exit code table.

12. **No package additions**.

## Tasks / Subtasks

- [ ] Task 1: Register `--non-interactive` CLI flag and update help text (AC: #1, #11)
  - [ ] Add `.option('--non-interactive', '...', false)` to `src/cli/commands/run.ts` commander definition
  - [ ] Write help text describing: flag semantics, canonical CI/CD invocation combo (`--non-interactive --halt-on none --events --output-format json`), and exit code table (0=all success or recovered, 1=some escalated, 2=run-level failure)
  - [ ] Thread `nonInteractive: boolean` through CLI option types down to orchestrator invocation call site
  - [ ] When `nonInteractive === true` and `--halt-on` is absent, default `haltOn` to `'critical'` before passing to orchestrator (AC5)

- [ ] Task 2: Implement stdin prompt suppression in Decision Router and orchestrator (AC: #2, #4, #5)
  - [ ] Locate all `readline`/`process.stdin` read paths in `src/modules/implementation-orchestrator/orchestrator-impl.ts` and any halt-decision call sites
  - [ ] When `nonInteractive === true`, replace each stdin read with `routeDecision` defaultAction lookup from Story 72-1's Decision Router
  - [ ] For critical halts skipped under `--non-interactive`: emit `decision:halt-skipped-non-interactive` event with payload `{ runId, decisionType, severity, defaultAction, reason }` (AC7)
  - [ ] Write skipped halt to `RunManifest` as `halt-skipped` (use `DoltClient` + `manifest-read.ts` helpers per AC6)
  - [ ] Add header comment in implementation file citing Phase D Story 54-6 + Story 72-1 + cross-project CI/CD enablement (AC10)

- [ ] Task 3: Exit code derivation at pipeline completion (AC: #3, #4)
  - [ ] Add exit code derivation logic in `src/modules/implementation-orchestrator/orchestrator-impl.ts` at pipeline completion (or in run-completion handler)
  - [ ] Implement the four exit-code conditions per AC3: all-success→0, recovered→0, escalated-only→1, failed/ceiling/fatal→2
  - [ ] Return derived exit code from orchestrator run method (or set it on a shared context)
  - [ ] In CLI layer (`src/cli/commands/run.ts`), call `process.exit(derivedCode)` after orchestrator returns (only when `--non-interactive` is set; fallback to existing behavior when false)

- [ ] Task 4: Declare and mirror new event type (AC: #7, #10)
  - [ ] Add `decision:halt-skipped-non-interactive` event type with payload shape `{ runId: string; decisionType: string; severity: string; defaultAction: string; reason: string }` to `packages/core/src/events/core-events.ts`
  - [ ] Mirror the event type in `src/core/event-bus.types.ts`

- [ ] Task 5: Unit tests (AC: #8)
  - [ ] Create `src/modules/decision-router/__tests__/non-interactive.test.ts`
  - [ ] Case (a): `--non-interactive` suppresses stdin reads — mock `readline`/`process.stdin`; assert never called when `nonInteractive=true`
  - [ ] Case (b): exit code 0 when `succeeded.length === total`, `failed.length === 0`, `escalated.length === 0`
  - [ ] Case (c): exit code 1 when `escalated.length > 0` and `failed.length === 0`
  - [ ] Case (d): exit code 2 when `failed.length > 0` (run-level failure)

- [ ] Task 6: Integration test (AC: #9)
  - [ ] Create `__tests__/integration/non-interactive-run.test.ts`
  - [ ] Spawn `substrate run --non-interactive --halt-on none --events --stories <test-fixture>` as child process using `spawnSync` or `spawn` with `stdio: ['ignore', 'pipe', 'pipe']` (closed stdin)
  - [ ] Assert process exits within timeout (no stdin blocking)
  - [ ] Assert exit code is 0, 1, or 2 per AC3 semantics (depending on test-fixture outcome)

## Dev Notes

### Architecture Constraints

- **No package additions** (AC12) — use only existing dependencies; no new npm packages
- **Canonical helpers** (AC6): all state writes use `RunManifest`; persistence uses `DoltClient`; run-id resolution via `manifest-read.ts` helpers — no new storage format invented
- **Story 72-1 dependency**: `routeDecision` from the Decision Router module is the authority for `defaultAction` values when stdin is suppressed; import from `src/modules/decision-router/index.ts`
- **Header comment** (AC10): implementation file must contain a comment at the top citing Phase D Story 54-6 (2026-04-05 original headless spec) + Story 72-1 (Decision Router consumed here) + cross-project CI/CD enablement (strata, agent-mesh)
- **process.exit placement**: call `process.exit(N)` at the CLI layer after orchestrator completes, not deep inside orchestrator; this keeps the orchestrator testable without real process termination

### File Paths

- `src/cli/commands/run.ts` — register `--non-interactive` flag; default `haltOn` to `critical` when flag is set and `--halt-on` is absent; call `process.exit(derivedCode)` after run
- `src/modules/decision-router/index.ts` — extend with non-interactive default-action mode (Story 72-2 may extend Story 72-1 here if they ship together as a single dispatch)
- `src/modules/decision-router/__tests__/non-interactive.test.ts` — NEW unit tests (≥4 cases per AC8)
- `__tests__/integration/non-interactive-run.test.ts` — NEW integration test (≥1 case per AC9)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — exit code derivation + stdin suppression wiring
- `packages/core/src/events/core-events.ts` — declare `decision:halt-skipped-non-interactive` event type
- `src/core/event-bus.types.ts` — mirror `decision:halt-skipped-non-interactive` event type

### Import Patterns

```typescript
// RunManifest — existing path (do not introduce new manifest format)
import { RunManifest } from '../../run-manifest';

// DoltClient — existing path
import { DoltClient } from '@substrate-ai/core';

// manifest-read.ts helpers — for run-id resolution
import { getLatestRun } from '../../manifest-read';

// Decision Router (from Story 72-1)
import { routeDecision } from '../decision-router/index';
```

Confirm exact import paths by reading adjacent orchestrator files before writing; the above are guidance-level, not guaranteed.

### Exit Code Derivation Logic

```typescript
function deriveExitCode(result: {
  succeeded: string[];
  recovered: string[];
  escalated: string[];
  failed: string[];
  total: number;
  costCeilingExhausted?: boolean;
  fatalHaltReached?: boolean;
  orchestratorDied?: boolean;
}): 0 | 1 | 2 {
  if (
    result.failed.length > 0 ||
    result.costCeilingExhausted ||
    result.fatalHaltReached ||
    result.orchestratorDied
  ) return 2;
  if (result.escalated.length > 0 && result.failed.length === 0) return 1;
  // all success or recovered
  return 0;
}
```

### Event Payload Shape (AC7)

```typescript
interface HaltSkippedNonInteractiveEvent {
  runId: string;
  decisionType: string;   // halt decision type that was skipped
  severity: string;       // e.g. 'critical'
  defaultAction: string;  // action applied (from routeDecision)
  reason: string;         // e.g. 'non-interactive: stdin prompt suppressed'
}
```

### Canonical CI/CD Invocation (for help text, AC11)

```
substrate run --non-interactive --halt-on none --events --output-format json
```

Exit code semantics for help text:
- `0` — all stories succeeded (or recovered cleanly)
- `1` — some stories escalated; run completed
- `2` — run-level failure (cost ceiling exhausted, fatal halt, orchestrator died)

### Integration Test Pattern (AC9)

```typescript
import { spawnSync } from 'child_process';

it('exits without reading stdin when --non-interactive is set', () => {
  const result = spawnSync(
    process.execPath,
    ['dist/cli.mjs', 'run', '--non-interactive', '--halt-on', 'none',
     '--events', '--stories', 'test-fixture'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],  // closed stdin
      timeout: 30_000,
    }
  );
  // Must not timeout (signal would be set)
  expect(result.signal).toBeNull();
  // Exit code must be 0, 1, or 2 (machine-readable)
  expect([0, 1, 2]).toContain(result.status);
});
```

### Testing Requirements

- Test framework: Vitest (consistent with all existing tests)
- Unit test: `src/modules/decision-router/__tests__/non-interactive.test.ts` — ≥4 cases (a–d per AC8)
- Integration test: `__tests__/integration/non-interactive-run.test.ts` — ≥1 case (AC9)
- Integration test must use a closed stdin pipe (`stdio: ['ignore', 'pipe', 'pipe']`); never pass `'inherit'` for stdin in non-interactive tests
- Build before running integration test: `npm run build` (produces `dist/cli.mjs`)
- Run unit tests: `npm run test:fast` during iteration; `npm test` pre-merge
- **NEVER run two vitest instances concurrently** — confirm `pgrep -f vitest` returns nothing before running

## Interface Contracts

- **Import**: `routeDecision` @ `src/modules/decision-router/index.ts` (from story 72-1 — Decision Router that 72-2 consumes)
- **Export**: `decision:halt-skipped-non-interactive` event type @ `packages/core/src/events/core-events.ts`
- **Export**: `decision:halt-skipped-non-interactive` event type @ `src/core/event-bus.types.ts` (mirror)

## Runtime Probes

```yaml
- name: non-interactive-flag-registered-in-help
  sandbox: host
  command: |
    node dist/cli.mjs run --help
  expect_stdout_regex:
    - '--non-interactive'
    - 'exit'
  description: >
    Verifies --non-interactive flag is registered and help text is updated.
    Requires `npm run build` to have been run first.

- name: non-interactive-exits-without-stdin-block
  sandbox: twin
  command: |
    set -e
    npm run build 2>/dev/null
    # Spawn run with --non-interactive; stdin redirected from /dev/null (closed).
    # timeout 30 catches any hang; exit codes 0/1/2 are all valid machine-readable exits.
    set +e
    timeout 30 node dist/cli.mjs run \
      --non-interactive \
      --halt-on none \
      --events \
      </dev/null
    EXITCODE=$?
    # Timeout exit = 124; all others (0,1,2) indicate machine-readable completion
    if [ "$EXITCODE" -eq 124 ]; then
      echo "FAIL: process hung on stdin read (timed out)"
      exit 1
    fi
    if [ "$EXITCODE" -eq 0 ] || [ "$EXITCODE" -eq 1 ] || [ "$EXITCODE" -eq 2 ]; then
      echo "exit-code-ok: $EXITCODE"
    else
      echo "unexpected-exit-code: $EXITCODE"
      exit 1
    fi
  expect_stdout_regex:
    - 'exit-code-ok'
  expect_stdout_no_regex:
    - 'FAIL:'
    - 'unexpected-exit-code'
  description: >
    Spawns substrate run --non-interactive with stdin from /dev/null.
    If the process reads stdin it will get EOF immediately and not block.
    If it hangs anyway (reading in a loop), timeout 30 catches it.
    Any of exit codes 0/1/2 is accepted; only a hang (124) or unknown code fails.
  timeout_ms: 60000

- name: halt-skipped-event-emitted-on-critical-halt
  sandbox: twin
  command: |
    set -e
    npm run build 2>/dev/null
    # Run without --halt-on (defaults to critical per AC5) to trigger halt-skipped path.
    # Capture all output; check for halt-skipped-non-interactive in NDJSON stream.
    set +e
    OUTPUT=$(timeout 30 node dist/cli.mjs run \
      --non-interactive \
      --events \
      --output-format json \
      </dev/null 2>&1)
    EXITCODE=$?
    if [ "$EXITCODE" -eq 124 ]; then
      echo "FAIL: process hung (timed out)"
      exit 1
    fi
    # Either the event is present (a halt was skipped) OR the run completed with no halts.
    # Both are valid; only a hang or crash is a probe failure.
    echo "exit-code: $EXITCODE"
    echo "$OUTPUT" | grep -q 'halt-skipped-non-interactive' \
      && echo "halt-skipped-event-present" \
      || echo "no-halt-skipped-event (no critical halt reached — acceptable)"
  expect_stdout_no_regex:
    - 'FAIL:'
  description: >
    Verifies that when --non-interactive is used without --halt-on, the run
    defaults to --halt-on critical and emits decision:halt-skipped-non-interactive
    if a critical halt is encountered. Absence of the event is also acceptable
    (it means no critical halt was reached in this run).
  timeout_ms: 60000
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
