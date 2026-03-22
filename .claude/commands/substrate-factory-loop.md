# Substrate Factory Loop

Autonomous implementation loop that runs stories through the substrate pipeline, handles escalations, validates, ships, and advances to the next batch — with `/bmad-party-mode` as the decision-making brain at every judgment point.

## Arguments

`$ARGUMENTS` — Story keys to start with (e.g., `40-1,40-2,...,40-13`), or `auto` to read from epics doc.

## The Loop

Execute this loop continuously until all stories are complete or party mode escalates to human.

### Phase 1: IMPLEMENT

1. Determine story batch:
   - If explicit stories provided: use them
   - If `auto`: read `_bmad-output/planning-artifacts/epics-and-stories-software-factory.md`, find the next epic whose dependencies are met, extract all story keys for that epic
2. Run the pipeline:
   ```bash
   substrate run --events --stories <keys>
   ```
   - Use `run_in_background: true` or `timeout: 600000`
   - Attach supervisor in parallel: `substrate supervisor --output-format json`
3. Monitor to completion:
   - Poll `substrate status --output-format json` every 60-90 seconds
   - Use `substrate health --output-format json` if quiet for >5 minutes
4. When complete, collect results:
   - `substrate metrics --output-format json`
   - Note: X succeeded, Y escalated, Z failed

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
- Re-run failed stories: `substrate run --events --stories <failed-keys>`
- Monitor to completion
- If escalations again → invoke party mode again (max 2 retry cycles, then escalate to human)

### Phase 3: AUTOMATED TESTS

1. Verify no vitest running: `pgrep -f vitest` returns nothing
2. Build: `npm run build` (timeout: 120000)
3. Run full test suite: `npm test` (timeout: 300000) — NOT test:fast, the FULL suite with e2e and coverage
4. Confirm results by checking for "Test Files" line in output

If tests fail, invoke `/bmad-party-mode`:

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

After fixes: re-run `npm test`. Loop until green (max 3 cycles, then escalate to human).

### Phase 4: REVIEW & SMOKE TEST

Invoke `/bmad-party-mode` with this prompt:

```
Stories [list keys] from Epic [N] have been implemented and all automated tests pass.

Your job — thorough review:
1. Read the git diff for all changes in this batch: `git diff <baseline-commit>..HEAD`
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
4. Stage all changed files: `git add -A` (but verify no sensitive files)
5. Commit:
   ```
   feat: Epic [N] — [epic title] (v[new version])

   Stories: [list of story keys completed]

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
   ```
6. Tag: `git tag v[new version]`
7. Push: `git push origin main --tags`
8. Poll GH Actions: `gh run list --limit 1 --json status,conclusion` every 30 seconds until complete
   - If CI fails → invoke `/bmad-party-mode` to diagnose and fix, then re-push
9. Update global CLI: `npm install -g substrate-ai@latest`
10. Verify: `substrate --version` matches new version

### Phase 6: NEXT

1. Read `_bmad-output/planning-artifacts/epics-and-stories-software-factory.md`
2. Check the dependency graph — which epics have all dependencies met?
3. Determine the next epic or story batch
4. Report: "Epic [N] complete. Next up: Epic [M] — [title] ([X] stories)"
5. Loop back to Phase 1 with the next batch

If all epics are complete → report final summary and stop.

## Human Escalation Protocol

The loop is autonomous. Human intervention is requested ONLY when:
- Party mode says "STUCK" (cannot resolve an issue)
- Max retry cycles exhausted (2 for escalations, 3 for test failures)
- CI fails after party mode fix attempt

When escalating to human:
1. Summarize what was attempted
2. Show the specific error/issue
3. Ask for guidance
4. Resume loop after human provides direction

## Important Rules

- **NEVER run `substrate` for local changes** — use `npm run substrate:dev` when testing local builds
- **Use the global `substrate` command** for pipeline runs (it's the published version)
- **NEVER run tests concurrently** — one vitest instance at a time
- **NEVER pipe test output** — no `tail`, `head`, `grep` on vitest
- **ALWAYS use timeout: 300000** for test runs, **timeout: 600000** for substrate runs
- **Fix substrate bugs in substrate** — never work around them in target projects
- **NEVER suggest wrapping up** — always proceed to next phase/batch
