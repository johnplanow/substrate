# Ship

Run the substrate CI pipeline locally, fix issues, commit, and push.

Matches the GitHub Actions CI pipeline: build → circular dep check → typecheck:gate → test:fast → push.

## Procedure

Execute these steps sequentially. If a step fails and you cannot fix it after two attempts, stop and report the issue to the user. Do NOT skip steps.

### Step 1: Build

```bash
npm run build 2>&1
```

Build MUST come first — `tsc --build` outputs are required for subsequent steps. If build fails:
1. Read each TypeScript error carefully
2. Fix the type issues in source files
3. Re-run `npm run build` to confirm clean

### Step 2: Circular dependency check

```bash
npm run check:circular 2>&1
```

If circular dependencies are found, trace the import cycle and break it. This is a hard gate in CI.

### Step 3: Type check (gate)

```bash
npm run typecheck:gate 2>&1
```

This is the strict typecheck (`tsc --noEmit -p tsconfig.typecheck.json`). If it fails:
1. Read the type errors
2. Fix them — this gate uses a stricter config than the build
3. Re-run to confirm clean

### Step 4: Tests

**IMPORTANT**: Before running, verify no other vitest instance is running:
```bash
pgrep -f vitest
```
If anything is returned, wait or kill it first.

Run unit tests (fast suite — excludes e2e/integration):
```bash
npm run test:fast 2>&1
```

**CRITICAL**: Use `timeout: 300000` (5 min). Do NOT pipe output through tail/head/grep. Do NOT run in background. Confirm results by checking for "Test Files" in output.

If tests fail:
1. Read the failure output
2. Determine if the test is wrong or the code is wrong
3. Fix the root cause
4. Re-run to confirm all pass
5. Report the test count

### Step 4.5: Empirical prompt-edit smoke (conditional)

**Trigger:** any staged or unstaged change touches `packs/bmad/prompts/*.md`. Otherwise SKIP this step.

```bash
git diff --cached --name-only HEAD; git diff --name-only HEAD
```

If neither output includes `packs/bmad/prompts/`, skip to Step 5.

**Why this step exists:** unit tests in Step 4 verify prompt CONTENT (regex / substring against the rendered prompt file) but not LLM BEHAVIOR. obs_2026-05-02_019 documented the cost of skipping empirical validation — a phantom regression cycle on obs_017's reopen episode (2026-05-02), where strata-side smoke against a stale local install produced a false-alarm reopen of substrate work that was correct. The discipline encoded here ensures the prompt change reaches the agent and produces the structural property the change targets, not just that the prompt file on disk has the right text.

**Procedure when triggered:**

1. **Identify the failure shape your prompt change targets.** Read the diff:
   ```bash
   git diff packs/bmad/prompts/
   ```
   Map the change to a structural property the rendered story should have. Examples:
   - obs_017 Phase 1 (state-integrating ACs → probes): `## Runtime Probes` heading present.
   - obs_017 Phase 2 (frontmatter declaration): `external_state_dependencies:` populated in story frontmatter.
   - obs_2026-04-26_014 / obs_2026-04-27_016 (event-driven ACs): probe section invokes a production trigger (e.g., `git merge`, `systemctl start`).
   - Other shapes: state the property explicitly before proceeding.

2. **Pick or author the smoke fixture.** The state-integrating fixture lives at `_bmad-output/test-fixtures/prompt-smoke-state-integrating-epic.md` (Story 999-1 — wall-to-wall subprocess / fs / git / database / network signals, covers Phase 1+2 shapes). If your prompt change targets a different shape (event-driven AC, probe-author capability, etc.), author a sibling fixture at `_bmad-output/test-fixtures/prompt-smoke-<shape>-epic.md` first. Each fixture must have ONE story with key shape `999-N` so cleanup is deterministic.

3. **Dispatch the smoke story USING THE LOCAL DEV BUILD** (not the global install — see CLAUDE.md "Dev Workflow — Testing Local CLI Changes"). The global `substrate` runs the published version and would NOT exercise your unpushed prompt change.
   ```bash
   npm run substrate:dev -- ingest-epic _bmad-output/test-fixtures/prompt-smoke-state-integrating-epic.md
   npm run substrate:dev -- run --events --stories 999-1 --max-review-cycles 1 > /tmp/smoke-prompt-edit.log 2>&1
   ```
   Use `run_in_background: true` and ScheduleWakeup for monitoring per CLAUDE.md pipeline-run rules. Cost ~$0.20–$0.40, wall-clock typically 10–20 min for a single story.

4. **Inspect the rendered story file** after dispatch completes:
   ```bash
   ls _bmad-output/implementation-artifacts/999-1*.md
   cat _bmad-output/implementation-artifacts/999-1-*.md
   ```

5. **Assert the structural property** identified in step 1. Use targeted greps so the result is unambiguous:
   - Phase 1 / state-integrating: `grep -c "^## Runtime Probes" _bmad-output/implementation-artifacts/999-1-*.md` returns ≥1.
   - Phase 2 / frontmatter: `grep -c "external_state_dependencies:" _bmad-output/implementation-artifacts/999-1-*.md` returns ≥1.
   - Event-driven / production-trigger: rendered probe section contains a known trigger pattern (`git merge`, `systemctl start`, `kill -<SIGNAL>`, `curl -X POST`, etc.).

6. **Clean up** so the smoke story doesn't pollute future runs:
   ```bash
   cd .substrate/state && dolt sql -q "DELETE FROM wg_stories WHERE epic = '999';"
   cd <project root>
   rm _bmad-output/implementation-artifacts/999-*.md _bmad-output/implementation-artifacts/999-*.md.bak 2>/dev/null
   ```

**On smoke failure:** STOP. Do not proceed to Step 5 (commit) or Step 6 (push). The prompt change does NOT produce the expected structural property in production dispatch. Investigate the obs_017-style hypothesis tree:
- Did the prompt actually render? (Look for the new prompt content in the dispatched-prompt log payload, if available.)
- Is there a classification gap? (The new prompt content may not match the AC's phrasing.)
- Is there a manifest / template-load failure? (Sprint 20 / probe-author silent-disable precedent.)

Fix the root cause, re-run smoke, only proceed to Step 5 once the assertion passes.

**On smoke success:** proceed to Step 5. Note the smoke result in the commit message body so the discipline is auditable from git history.

### Step 5: Commit

Only if there are changes to commit:

1. `git status` — review what changed
2. `git diff` — review the actual changes
3. Stage the relevant files (do NOT use `git add -A` — be specific about files)
4. Commit with a descriptive message summarizing what was fixed
5. Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

If no changes, skip to Step 6.

### Step 6: Version bump, tag, and push

1. Read the current version from `package.json`
2. Bump the patch version (e.g., 0.19.27 → 0.19.28). Update ALL FOUR workspace package.json files (root + packages/core + packages/sdlc + packages/factory) — they must match.
3. **Run `npm run version:sync`** — aligns cross-package `dependencies` references in `packages/factory/package.json` and `packages/sdlc/package.json` to point at the new `@substrate-ai/core` version. Without this, the workspace tarballs have a broken internal dep graph.
4. **Run `npm install --package-lock-only --no-audit --no-fund`** — regenerates `package-lock.json` from the synced package.json files. Without this, `npm ci` in CI/publish workflows fails with EUSAGE / "Missing: @substrate-ai/core@<old> from lock file" and the tag is burned.
5. Commit the version bump with a message summarizing what's in the release:
   ```
   chore: bump version to v{VERSION} — {brief summary}
   ```
   Stage: package.json, package-lock.json, packages/*/package.json. All five must be in the same commit so the lockfile and package.json files stay in sync at every commit boundary.
6. Tag the commit: `git tag v{VERSION}`
7. Push commit and tag:
   ```bash
   git push && git push --tags
   ```

The tag push triggers the GitHub Actions npm publish workflow.

If push fails due to remote changes, `git pull --rebase` and re-run from Step 1.

**Burned-tags recovery**: if a publish workflow run fails at install with EUSAGE, the version is burned (per memory's published-version-immutability rule — `npm publish` rejects re-publishing the same version even after the failed attempt is deleted). Bump to the next version, fix the lockfile, ship that. Delete the burned tag with `git push --delete origin v{VERSION}`.

### Step 7: Verify CI

```bash
sleep 15 && gh run list --limit 1
```

Report the CI run status. If still in progress, tell the user and offer to check back.

## Summary

After all steps, report concisely:
- What was fixed (if anything)
- Test count and result
- Version and tag
- Commit hash
- CI run status
