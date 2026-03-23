# Substrate Factory Loop

Autonomous implementation loop that runs stories through the substrate pipeline, handles escalations, validates, ships, and advances to the next batch — with `/bmad-party-mode` as the decision-making brain at every judgment point.

## Arguments

`$ARGUMENTS` — Story keys to start with (e.g., `40-1,40-2,...,40-13`), or `auto` to read from epics doc.

## State Persistence

Before starting, read or create `.substrate/factory-loop-state.json`:
```json
{
  "currentEpic": null,
  "baselineCommit": null,
  "lastShippedVersion": null,
  "epicsCompleted": [],
  "totalCostUsd": 0,
  "totalStoriesShipped": 0,
  "totalStoriesEscalated": 0
}
```
Update this file at every phase transition. This survives session boundaries and context compression.

## The Loop

Execute this loop continuously until all stories are complete or party mode escalates to human.

### Phase 0: PRE-FLIGHT

Run BEFORE each epic to establish a clean baseline:

1. Record baseline commit: `git rev-parse HEAD` → save to state file as `baselineCommit`
2. Verify clean working tree: `git status --short` should be empty (or only untracked _bmad-output files)
3. Run regression gate: `npm run test:fast` (timeout: 300000) — confirms previous epic's work hasn't regressed
   - If tests fail HERE, something regressed between sessions — invoke party mode to diagnose before proceeding
4. Verify Dolt is initialized and writable:
   ```bash
   dolt sql -q "SELECT 1" 2>&1
   ```
   - If this fails: run `substrate init --dolt -y` then restore CLAUDE.md from git: `git checkout -- CLAUDE.md`
5. Update state file with `currentEpic`

### Phase 1: IMPLEMENT

1. Determine story batch:
   - If explicit stories provided: use them
   - If `auto`: read `_bmad-output/planning-artifacts/epics-and-stories-software-factory.md`, find the next epic whose dependencies are met, extract all story keys for that epic
2. Verify story keys are valid: check that each key matches `^\d+-\d+[a-z]?$` (supports suffixed keys like `41-6a`, `41-6b`)
3. Run the pipeline:
   ```bash
   substrate run --events --max-review-cycles 3 --stories <keys>
   ```
   - Use `run_in_background: true` or `timeout: 600000`
   - Attach supervisor for runs with 10+ stories: `substrate supervisor --run-id <run_id> --output-format json` (always pass `--run-id` to prevent cross-session kills)
   - Do NOT attach supervisor if Dolt telemetry persistence has issues (check Phase 0 step 4)
4. Monitor to completion:
   - Poll `substrate status --output-format json` every 90-120 seconds
   - Use `substrate health --output-format json` if quiet for >10 minutes
   - If health shows `verdict: STALLED` with `child_pids: []` and stories still PENDING, the pipeline process may have died — check background task output
5. When complete, collect results:
   - `substrate metrics --output-format json` — record cost, token usage, wall clock time
   - Note: X succeeded, Y escalated, Z failed
   - Update state file with results

### Phase 2: ESCALATIONS (if any stories escalated or failed)

Invoke `/bmad-party-mode` with this prompt:

```
Substrate pipeline run completed. Results: [X succeeded, Y escalated, Z failed].

Escalated/failed stories: [list them with keys]

Your job:
1. Read the escalation context for each failed story — check _bmad-output/implementation-artifacts/ for the story files, check git diff for what was attempted
2. Diagnose the root cause of each failure
3. Propose and APPLY fixes directly — do not ask for permission
4. After fixes are applied, tell me which stories need re-running

If you cannot resolve a failure after examining it thoroughly, say "STUCK: [reason]" and I will escalate to the human.
```

After party mode applies fixes:
- Re-run failed stories: `substrate run --events --max-review-cycles 3 --stories <failed-keys>`
- Monitor to completion
- If escalations again → invoke party mode again (max 2 retry cycles, then escalate to human)

### Phase 2.5: INFRASTRUCTURE & QUALITY AUDIT

Run automated checks on the pipeline output and working tree. Only invoke party mode if issues are detected.

**Automated checks (no LLM needed):**

1. **Adapter fallback**: Search pipeline output for `"InMemoryDatabaseAdapter"`. If found, flag: "Dolt adapter fell back to InMemory — cost and telemetry data was NOT persisted for this run."
2. **Process failure ratio**: Count stories where pipeline said "failed" but implementation files + tests exist and pass. If >10% are process failures (agent crash/timeout, not code issues), flag: "High process failure rate ([X]%) — investigate dispatch timeouts and agent stability."
3. **Orphaned processes**: Run `pgrep -fa "claude.*max-turns"` — if any claude agents are still running after pipeline completion, flag and kill them.
4. **Rogue working tree changes**: Compare `git status --short` against expected files. Flag any unexpected modifications outside the epic's package scope.
5. **Test coverage for new files**: For each new source file in `git diff --name-only`, check if a corresponding `*.test.ts` file exists. Flag any new source files without test coverage.
6. **Independent typecheck**: Run `npm run typecheck:gate` (timeout: 120000). Do NOT rely on the pipeline's build verification alone — the pipeline may use a different tsconfig.

**If any checks fail:**
Invoke `/bmad-party-mode` with:

```
Infrastructure audit found [N] issues after pipeline run for Epic [X]:

[List each flagged issue with details]

Your job:
1. For each issue: determine if it's a real problem or acceptable
2. For real problems: fix them directly (code changes, process cleanup, etc.)
3. For infrastructure issues (Dolt, adapter): determine if data integrity is affected
4. For test coverage gaps: write the missing tests

Apply all fixes, re-run typecheck:gate to confirm, then say "AUDIT CLEAN" or "STUCK: [reason]".
```

**If all checks pass:** Log "Infrastructure audit: CLEAN" and proceed to Phase 3.

### Phase 3: AUTOMATED TESTS

1. Verify no vitest running: `pgrep -f vitest` returns nothing
2. Build: `npm run build` (timeout: 120000)
3. Typecheck: `npm run typecheck:gate` (timeout: 120000) — catches type mismatches that the bundler misses. This MUST pass before proceeding — it mirrors the CI typecheck gate.
4. Run full test suite: `npm test` (timeout: 300000) — NOT test:fast, the FULL suite with e2e and coverage
5. Confirm results by checking for "Test Files" line in output

If typecheck or tests fail, invoke `/bmad-party-mode`:

```
Full test suite failed after implementing stories [list keys].

Test output: [paste the failure output]

Your job:
1. Diagnose which tests failed and why
2. Determine if this is a bug in the new code or a pre-existing issue
3. Fix the failing tests or the code causing failures — apply fixes directly
4. Do NOT weaken tests to make them pass — fix the actual issue

If you cannot resolve the failures, say "STUCK: [reason]" and I will escalate to the human.
```

After fixes: re-run `npm run typecheck:gate` AND `npm test`. Loop until both green (max 3 cycles, then escalate to human).

### Phase 4: REVIEW & SMOKE TEST

**MANDATORY: This phase is NEVER skipped.** Even if all tests pass and no issues were found in Phase 2.5/3, the review must run. Pipeline agents are good at writing isolated code but weak at verifying end-to-end integration. The review is what catches dead code, unwired functions, type mismatches between packages, and behavioral divergences.

Invoke `/bmad-party-mode` with this prompt:

```
Stories [list keys] from Epic [N] have been implemented and all automated tests pass.

Your job — thorough review:
1. Read the git diff for all changes in this batch: `git diff <baseline-commit>..HEAD`
   (baseline commit is in .substrate/factory-loop-state.json)
2. Review code quality, correctness, and adherence to the story acceptance criteria
3. Cross-reference against the PRD acceptance criteria (read _bmad-output/planning-artifacts/prd-software-factory.md)
4. Identify test gaps — what behaviors are NOT covered by the automated test suite?
5. For each test gap: either write the missing test and add it, OR if it requires manual verification, describe the exact steps
6. Run any manual verification steps you can (e.g., `npm run substrate:dev -- <command>` to test CLI behavior)
7. If you find issues — fix them directly, re-run tests, confirm green

When satisfied, respond with: "SHIP IT" followed by a brief summary of what was reviewed and any tests you added.

If you find issues you cannot resolve, say "STUCK: [reason]" and I will escalate to the human.
```

If party mode says "SHIP IT" → proceed to Phase 5.
If party mode says "STUCK" → escalate to human, pause loop.

### Phase 5: SHIP

1. Read current version from `package.json`
2. Determine bump type:
   - If this is a full epic completion: minor bump (0.8.x → 0.9.0)
   - If this is a partial batch or fix: patch bump (0.8.6 → 0.8.7)
3. Edit `package.json` with new version
4. Stage all changed files: `git add -A` (but verify no sensitive files — no .env, no credentials)
5. Commit:
   ```
   feat: Epic [N] — [epic title] (v[new version])

   Stories: [list of story keys completed]

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
   ```
6. Tag: `git tag v[new version]`
7. Push: `git push origin main --tags`
8. Wait for GH Actions CI to complete:
   ```bash
   # Get the run triggered by our push
   gh run list --branch main --limit 1 --json databaseId,status,conclusion
   ```
   - Poll every 30 seconds until `status` is `completed`
   - If `conclusion` is `success` → proceed
   - If `conclusion` is `failure`:
     a. Get the failed run logs: `gh run view <id> --log-failed`
     b. Invoke `/bmad-party-mode` with the failure logs to diagnose and fix
     c. After fix: commit, re-tag (delete old tag first: `git tag -d v[ver] && git push origin :refs/tags/v[ver]`), push again
     d. Re-poll CI (max 2 CI retry cycles, then escalate to human)
9. Once CI green, update global CLI with exact version (avoids npm cache staleness):
   ```bash
   npm cache clean --force 2>/dev/null
   npm install -g substrate-ai@<exact-new-version>
   ```
10. Verify: `substrate --version` matches new version
    - If mismatch, wait 30s and retry (max 3 attempts — npm registry propagation delay)
11. Collect and report cost metrics:
    ```bash
    substrate metrics --output-format json
    ```
    - Report: total cost, tokens used, stories/hour, cost per story
    - Update state file with `lastShippedVersion`, cumulative cost, story counts
12. If supervisor was attached, collect analysis:
    ```bash
    substrate metrics --analysis <run_id> --output-format json
    ```
    - Report any optimization recommendations (model downgrades, prompt improvements)

### Phase 6: NEXT

1. Read `_bmad-output/planning-artifacts/epics-and-stories-software-factory.md`
2. Check the dependency graph — which epics have all dependencies met?
3. Determine the next epic or story batch
4. Update state file: add current epic to `epicsCompleted`
5. Report: "Epic [N] complete. Next up: Epic [M] — [title] ([X] stories). Cumulative: [Y] stories shipped, $[Z] total cost."
6. Loop back to Phase 0 (pre-flight) with the next batch

If all epics are complete → report final summary and stop.

## Human Escalation Protocol

The loop is autonomous. Human intervention is requested ONLY when:
- Party mode says "STUCK" (cannot resolve an issue)
- Max retry cycles exhausted (2 for escalations, 3 for test failures)
- CI fails after party mode fix attempt
- Pre-flight regression gate fails (previous epic's work regressed)

When escalating to human:
1. Summarize what was attempted
2. Show the specific error/issue
3. Report current state (epic, stories completed/escalated, cost so far)
4. Ask for guidance
5. Resume loop after human provides direction

## Important Rules

- **NEVER run `substrate` for local changes** — use `npm run substrate:dev` when testing local builds
- **Use the global `substrate` command** for pipeline runs (it's the published version)
- **NEVER run tests concurrently** — one vitest instance at a time
- **NEVER pipe test output** — no `tail`, `head`, `grep` on vitest
- **ALWAYS use timeout: 300000** for test runs, **timeout: 600000** for substrate runs
- **Fix substrate bugs in substrate** — never work around them in target projects
- **NEVER suggest wrapping up** — always proceed to next phase/batch
- **Always use `--max-review-cycles 3`** — default 2 causes ~28% false escalation on extraction/migration stories
- **Always run `npm run typecheck:gate`** before pushing — catches type mismatches the bundler misses
- **Use exact version for global install** — `npm install -g substrate-ai@<version>` not `@latest` (avoids cache staleness)
- **Record baseline commit in state file** — survives session boundaries for accurate diffs
- **Verify Dolt before attaching supervisor** — supervisor interprets telemetry write failures as stalls
- **Always pass `--run-id` when attaching supervisor** — prevents cross-session kills
- **NEVER skip Phase 4 (Review)** — pipeline agents write isolated code well but miss integration issues; review catches dead code, unwired functions, and type mismatches
- **No shortcuts, no tech debt** — never defer known issues to "fix later"; fix all issues before advancing to the next epic; rank decisions by correctness, not speed
