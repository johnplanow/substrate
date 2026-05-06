---
external_state_dependencies:
  - subprocess
  - filesystem
  - git
  - database
---

# Story 69-1: `substrate reconcile-from-disk` CLI command

## Story

As a substrate operator,
I want a `substrate reconcile-from-disk` command that reconciles `wg_stories.status` against actual working-tree and git history state,
so that I can recover cleanly from Path A incidents (orchestrator-death mid-dispatch) without manually updating Dolt rows or re-running already-completed story work.

## Acceptance Criteria

<!-- source-ac-hash: ad82d8c4f78c30937094f682f1d88860d2e4dcbc645fcb3774612d1da47db96e -->

1. New command file `src/cli/commands/reconcile-from-disk.ts`
   exporting a Commander subcommand registered in
   `src/cli/index.ts`. Command shape:
   `substrate reconcile-from-disk [--run-id <id>] [--dry-run]
   [--yes] [--output-format <human|json>]`.

2. **`--run-id` resolution**: when omitted, default to the most
   recent run in `.substrate/runs/manifest.json`. When no runs
   exist, exit 1 with friendly error pointing at `substrate
   metrics --output-format json` for run history.

3. **Discovery phase**: for each non-`complete`,
   non-`cancelled` story in the run manifest, build a per-story
   diff record: `{ storyKey, autoCommittedSha?: string,
   modifiedFiles: string[], reconcilable: boolean }`. `reconcilable`
   is `true` iff the story has either an auto-commit OR
   working-tree changes that match its `target_files` declaration.

4. **Validation phase**: run gates in order: build →
   check:circular → typecheck:gate → test:fast. Each gate via
   `child_process.spawnSync` with explicit timeout (180/60/120/300s
   respectively). On any gate failure: capture stderr/stdout (64KB
   tail-window per Story 66-5 pattern), emit
   `pipeline:reconcile-gate-failed` event, exit code 1.

5. **Reconciliation phase**: present plan to operator (per-story
   diff summary), prompt `[y/N]` unless `--yes` passed. On
   confirmation, open Dolt transaction via existing
   `DoltClient.transact()` (Story 53-14 pattern); UPDATE all
   candidate stories' `status='complete'` + `updated_at` in single
   transaction; commit. On decline OR `--dry-run`: print plan,
   exit 0, no Dolt write.

6. **`--dry-run` flag**: skips both gate execution AND Dolt
   mutation. Prints discovery output + would-run gate list +
   would-update story list. Exit 0.

7. **`--yes` flag**: skips operator confirmation prompt. Used for
   programmatic invocation from Epic 70 / 73 (deferred). Gates
   STILL run; gate failure still aborts.

8. **`--output-format json`**: structured output with
   `{ runId, candidates: [...], gateResults: [...], reconciled:
   boolean, affectedStoryKeys: [...] }`. Default human-readable.

9. **Idempotency**: re-running on a run where all candidate
   stories are already `complete` is a no-op — exit 0 with
   `affectedStoryKeys: []`.

10. **New event types** declared in
    `packages/core/src/events/core-events.ts` AND mirrored in
    `src/core/event-bus.types.ts` `OrchestratorEvents` (per Epic 66
    Story 66-4 typecheck:gate discipline — both interfaces must
    stay in sync, typecheck:gate catches mirror gaps):
    - `pipeline:reconcile-from-disk` — `{ runId, affectedStories,
      gatesPassed, operatorConfirmed, durationMs }`
    - `pipeline:reconcile-gate-failed` — `{ runId, failedGate,
      stderrTail, stdoutTail, durationMs }`

11. **Tests** at `src/__tests__/cli/reconcile-from-disk.test.ts`
    (unit, ≥7 cases): (a) discovery with auto-commit detection,
    (b) discovery with working-tree-change detection, (c) gate
    failure → no Dolt write + exit 1, (d) operator decline → no
    Dolt write + exit 0, (e) idempotency on already-reconciled
    run, (f) `--dry-run` skips both gates and write, (g) no active
    run → friendly error.

12. **Integration test** at
    `__tests__/integration/reconcile-from-disk.test.ts` (≥1
    end-to-end case using real `mktemp -d` fixture per Story
    65-5/67-2 discipline): real git init + real Dolt fixture +
    real `feat(story-N-M)` commit + real working-tree change →
    real reconcile-from-disk invocation → asserts Dolt row
    transitioned to `complete`.

13. **Header comment** in implementation file cites Epic 66
    (run a832487a), Epic 67 (run a59e4c96), and Epic 68
    (run a59e4c96-13e0-4727-8f46-6aa95a7e134c) as motivating
    Path A reconciliation incidents, per Story 60-4/60-10
    convention.

14. **Commit message** references Path A reconciliation pattern +
    Epic 66/67/68 motivating incidents + that this is the
    foundation primitive for Epic 70 / 73.

## Tasks / Subtasks

- [ ] Task 1: Scaffold Commander subcommand + event type declarations (AC: #1, #10, #13)
  - [ ] Create `src/cli/commands/reconcile-from-disk.ts` with header comment citing Epic 66 (a832487a), Epic 67 (a59e4c96), Epic 68 (a59e4c96-13e0-4727-8f46-6aa95a7e134c)
  - [ ] Register Commander subcommand `reconcile-from-disk` with flags `--run-id`, `--dry-run`, `--yes`, `--output-format`
  - [ ] Register subcommand in `src/cli/index.ts`
  - [ ] Declare `pipeline:reconcile-from-disk` and `pipeline:reconcile-gate-failed` event types in `packages/core/src/events/core-events.ts` (SdlcEvents interface)
  - [ ] Mirror both event types in `src/core/event-bus.types.ts` `OrchestratorEvents` with JSDoc noting Story 66-4 discipline

- [ ] Task 2: Implement run-id resolution + discovery phase (AC: #2, #3, #9)
  - [ ] Implement `--run-id` resolution: load most-recent run from `.substrate/runs/manifest.json`; exit 1 with friendly error + `substrate metrics --output-format json` hint when no runs exist
  - [ ] Filter manifest stories to non-`complete`, non-`cancelled` candidates; early-exit with `affectedStoryKeys: []` if none remain (idempotency)
  - [ ] For each candidate: run `git log --oneline --since=<manifest.started_at> --grep "feat(story-<key>"` to detect auto-committed SHA (regex `FEAT_COMMIT_PATTERN = /^feat\(story-([0-9]+-[0-9]+)\)/m`)
  - [ ] For each candidate: scan `target_files` from manifest against `git status --porcelain` output to find working-tree modifications; fall back to `git diff --name-only HEAD@{<ts>} HEAD` via reflog when available
  - [ ] Build per-story diff record: `{ storyKey, autoCommittedSha?: string, modifiedFiles: string[], reconcilable: boolean }`

- [ ] Task 3: Implement `--dry-run` path + validation gate chain (AC: #4, #6, #7)
  - [ ] If `--dry-run`: print discovery output + would-run gate list + would-update story list, exit 0 without running gates or writing Dolt
  - [ ] Implement gate chain runner: build (180s) → check:circular (60s) → typecheck:gate (120s) → test:fast (300s) via `child_process.spawnSync`
  - [ ] On gate failure: capture stderr/stdout with 64KB tail-window (Story 66-5 pattern), emit `pipeline:reconcile-gate-failed` event, exit code 1
  - [ ] Gates always run when `--yes` is passed (only confirmation prompt is skipped, not gates)

- [ ] Task 4: Implement reconciliation phase + output formatting (AC: #5, #7, #8)
  - [ ] Print human-readable plan: per-story diff summary showing runId prominently + which stories will be marked `complete`
  - [ ] Prompt `Reconcile N stories to status='complete'? [y/N]` unless `--yes` flag passed; on decline exit 0 with no Dolt write
  - [ ] On confirmation: open Dolt transaction via `DoltClient.transact()` (Story 53-14 pattern); run single `UPDATE wg_stories SET status='complete', updated_at=<utc-now> WHERE story_key IN (<candidates>) AND run_id = <run_id>` atomically
  - [ ] Emit `pipeline:reconcile-from-disk` event with `{ runId, affectedStories, gatesPassed, operatorConfirmed, durationMs }`
  - [ ] Implement `--output-format json` structured output: `{ runId, candidates, gateResults, reconciled, affectedStoryKeys }`; default to human-readable

- [ ] Task 5: Unit tests (AC: #11)
  - [ ] Case (a): discovery with auto-commit detection — mock `git log` returning `feat(story-N-M)` commit
  - [ ] Case (b): discovery with working-tree-change detection — mock `git status --porcelain` with matching target_files
  - [ ] Case (c): gate failure → no Dolt write + exit 1 — mock `spawnSync` returning non-zero for `build`
  - [ ] Case (d): operator decline → no Dolt write + exit 0 — mock readline responding `n`
  - [ ] Case (e): idempotency — all candidate stories already `complete` → exit 0 with `affectedStoryKeys: []`
  - [ ] Case (f): `--dry-run` skips both gates and Dolt write
  - [ ] Case (g): no active run → friendly error mentioning `substrate metrics --output-format json`

- [ ] Task 6: Integration test with real fixtures (AC: #12)
  - [ ] Create `__tests__/integration/reconcile-from-disk.test.ts`
  - [ ] Use `mktemp -d` fixture: real `git init`, real Dolt fixture (or in-memory fallback), write `.substrate/runs/manifest.json` with a dispatched story entry
  - [ ] Create real `feat(story-N-M)` commit in git history since `manifest.started_at`
  - [ ] Invoke reconcile-from-disk via real CLI invocation (`npm run substrate:dev -- reconcile-from-disk --yes`)
  - [ ] Assert Dolt row transitions to `complete` OR assert JSON output contains `affectedStoryKeys` with the story key

## Dev Notes

### Architecture Constraints

- **File placement**: command implementation at `src/cli/commands/reconcile-from-disk.ts` (NOT in packages/core — this is an orchestrator-layer CLI command)
- **Commander registration**: follow pattern in `src/cli/index.ts` for other commands (see `src/cli/commands/resume.ts`, `src/cli/commands/status.ts` as closest analogs)
- **Event type mirror discipline** (Story 66-4): new event types MUST appear in BOTH `packages/core/src/events/core-events.ts` (SdlcEvents) AND `src/core/event-bus.types.ts` (OrchestratorEvents). The typecheck:gate CI step catches any gap. Refer to the `dispatch:spawnsync-timeout` pattern (line ~553 in event-bus.types.ts) as the template.
- **Dolt transaction pattern**: use `DoltClient.transact()` introduced in Story 53-14. Single transaction guarantees atomicity across N story updates.
- **spawnSync gate pattern**: follow the Story 66-5 subprocess stderr/stdout 64KB tail-window capture pattern used in the gate chain. See existing usage in `src/cli/commands/` for examples.
- **Manifest reading**: use `resolveRunManifest()` from `src/cli/commands/manifest-read.ts` — do NOT re-implement manifest loading logic.
- **Git operations**: run via `child_process.spawnSync('git', [...])` with `cwd` set to the project root, not `process.cwd()` (avoid the bash-session-drift footgun documented in obs_025).
- **`FEAT_COMMIT_PATTERN` constant**: define as `/^feat\(story-([0-9]+-[0-9]+)\)/m` — configurable as a named constant so unit tests can assert it is exercised by auto-commit detection.

### Testing Requirements

- Unit tests at `src/__tests__/cli/reconcile-from-disk.test.ts` using vitest
- Mock `child_process.spawnSync` for gate chain tests — do NOT spawn real processes in unit tests
- Mock `DoltClient.transact()` to verify it is (or is not) called based on flow paths
- Integration test MUST use `mktemp -d` for fixture isolation (Story 65-5/67-2 discipline) — never use a shared directory
- Integration test should use the in-memory Dolt adapter if real Dolt is not available in CI; add an `if (!process.env.DOLT_DSN) { test.skip('Dolt not configured') }` guard
- Test the 64KB tail-window capture: ensure stderr/stdout beyond 64KB is truncated (not that it throws)
- Do NOT pipe test output — run vitest directly per CLAUDE.md rules

### Key File References

- `src/cli/commands/manifest-read.ts` — manifest resolution utility
- `src/cli/commands/resume-drift-detector.ts` — working-tree scan pattern (Story 66-3)
- `src/cli/commands/resume.ts` — Commander subcommand wiring pattern
- `packages/core/src/events/core-events.ts` — SdlcEvents declaration target
- `src/core/event-bus.types.ts` — OrchestratorEvents mirror target
- `.substrate/runs/manifest.json` — runtime manifest location

### Commit Message Convention (AC #14)

The commit message MUST reference:
- Path A reconciliation pattern (codifies the 7-step manual procedure from `.claude/commands/ship.md` Step 5)
- Motivating incidents: Epic 66 (run a832487a), Epic 67 (run a59e4c96), Epic 68 (run a59e4c96-13e0-4727-8f46-6aa95a7e134c)
- That this is the foundation primitive for Epic 70 / 73

## Interface Contracts

- **Import**: `resolveRunManifest` @ `src/cli/commands/manifest-read.ts` (from Story 52-3+)
- **Import**: `DoltClient.transact()` @ persistence layer (from Story 53-14)
- **Export**: `pipeline:reconcile-from-disk` event type @ `packages/core/src/events/core-events.ts` (SdlcEvents)
- **Export**: `pipeline:reconcile-gate-failed` event type @ `packages/core/src/events/core-events.ts` (SdlcEvents)

## Runtime Probes

```yaml
- name: reconcile-dry-run-exits-clean
  sandbox: host
  command: |
    set -e
    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    git init -q
    git config user.email test@example.com
    git config user.name test
    mkdir -p .substrate/runs
    cat > .substrate/runs/manifest.json << 'EOF'
    {
      "version": 1,
      "runs": [{
        "runId": "test-run-001",
        "started_at": "2026-05-01T00:00:00Z",
        "stories": [{"storyKey": "69-1", "status": "dispatched"}]
      }]
    }
    EOF
    git add . && git commit -qm "initial"
    git commit --allow-empty -m "feat(story-69-1): implement reconcile-from-disk"
    cd <REPO_ROOT>
    node dist/cli.mjs reconcile-from-disk --dry-run --run-id test-run-001 --project-root "$TMPDIR" --output-format json
    rm -rf "$TMPDIR"
  expect_stdout_no_regex:
    - '"reconciled"\s*:\s*true'
    - '"error"'
  expect_stdout_regex:
    - '"runId"'
    - '"candidates"'
  description: dry-run exits 0 with discovery output and no Dolt mutation

- name: reconcile-discovers-feat-commit
  sandbox: host
  command: |
    set -e
    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    git init -q
    git config user.email test@example.com
    git config user.name test
    mkdir -p .substrate/runs
    cat > .substrate/runs/manifest.json << 'EOF'
    {
      "version": 1,
      "runs": [{
        "runId": "test-run-002",
        "started_at": "2026-05-01T00:00:00Z",
        "stories": [
          {"storyKey": "69-1", "status": "dispatched"},
          {"storyKey": "69-2", "status": "dispatched"}
        ]
      }]
    }
    EOF
    git add . && git commit -qm "initial"
    git commit --allow-empty -m "feat(story-69-1): ship reconcile-from-disk"
    git commit --allow-empty -m "feat(story-69-2): ship second story"
    cd <REPO_ROOT>
    node dist/cli.mjs reconcile-from-disk --dry-run --run-id test-run-002 --project-root "$TMPDIR" --output-format json
    rm -rf "$TMPDIR"
  expect_stdout_regex:
    - '"storyKey"\s*:\s*"69-1"'
    - '"storyKey"\s*:\s*"69-2"'
    - '"reconcilable"\s*:\s*true'
  description: discovery phase detects feat commits for ≥2 stories in fixture (multi-resource fixture per Story 65-5 rule)

- name: reconcile-idempotent-on-complete-run
  sandbox: host
  command: |
    set -e
    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    git init -q
    git config user.email test@example.com
    git config user.name test
    mkdir -p .substrate/runs
    cat > .substrate/runs/manifest.json << 'EOF'
    {
      "version": 1,
      "runs": [{
        "runId": "test-run-003",
        "started_at": "2026-05-01T00:00:00Z",
        "stories": [
          {"storyKey": "69-1", "status": "complete"},
          {"storyKey": "69-2", "status": "cancelled"}
        ]
      }]
    }
    EOF
    git add . && git commit -qm "initial"
    cd <REPO_ROOT>
    node dist/cli.mjs reconcile-from-disk --dry-run --run-id test-run-003 --project-root "$TMPDIR" --output-format json
    rm -rf "$TMPDIR"
  expect_stdout_regex:
    - '"affectedStoryKeys"\s*:\s*\[\]'
  description: idempotency — all stories already complete/cancelled → no-op exit 0
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
